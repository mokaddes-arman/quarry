'use strict';

const express = require('express');
const { z } = require('zod');
const { asyncHandler } = require('../middleware/errorHandler');
const { validateBody, validateQuery, validateUuidParam } = require('../middleware/validate');
const conversations = require('../services/conversations');
const access = require('../services/access');

const router = express.Router();

// Every /:id route below is a conversation; resolve it within the caller's
// project scope before any handler runs.
router.param('id', async (req, _res, next, id) => {
  try {
    req.conversation = await access.assertOwned('conversation', req.user, id);
    return next();
  } catch (err) {
    return next(err);
  }
});

const retrievalSchema = z
  .object({
    topK: z.coerce.number().int().min(1).max(50).optional(),
    vectorCandidates: z.coerce.number().int().min(1).max(200).optional(),
    keywordCandidates: z.coerce.number().int().min(1).max(200).optional(),
    minScore: z.coerce.number().min(-1).max(1).optional(),
    rerankEnabled: z.boolean().optional(),
    includeHistoricalVersions: z.boolean().optional(),
    maxContextChars: z.coerce.number().int().min(500).max(200000).optional(),
  })
  .strict();

const askSchema = z.object({
  question: z.string().trim().min(1, 'A question is required').max(8000),
  stream: z.boolean().optional().default(true),
  llmConfigId: z.string().uuid().optional().nullable(),
  crossProject: z.boolean().optional().default(false),
  projectIds: z.array(z.string().uuid()).max(50).optional(),
  retrieval: retrievalSchema.optional(),
  allowUngroundedAnswer: z.boolean().optional().default(false),
});

router.post(
  '/projects/:projectId/conversations',
  validateUuidParam('projectId'),
  access.requireProjectAccess('projectId'),
  validateBody(
    z.object({
      title: z.string().trim().max(200).optional(),
      llmConfigId: z.string().uuid().optional().nullable(),
      provider: z.string().trim().max(100).optional().nullable(),
      model: z.string().trim().max(200).optional().nullable(),
      retrievalSettings: retrievalSchema.optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const conversation = await conversations.createConversation(req.params.projectId, req.validated);
    res.status(201).json({ conversation });
  }),
);

router.get(
  '/conversations/:id',
  validateUuidParam('id'),
  asyncHandler(async (req, res) => {
    const { sources, ...conversation } = await conversations.getConversation(req.params.id);
    res.json({ conversation, sources });
  }),
);

router.patch(
  '/conversations/:id',
  validateUuidParam('id'),
  validateBody(
    z.object({
      title: z.string().trim().min(1).max(200).optional(),
      archived: z.boolean().optional(),
      llmConfigId: z.string().uuid().optional().nullable(),
      provider: z.string().trim().max(100).optional().nullable(),
      model: z.string().trim().max(200).optional().nullable(),
      retrievalSettings: retrievalSchema.optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    res.json({ conversation: await conversations.updateConversation(req.params.id, req.validated) });
  }),
);

router.delete(
  '/conversations/:id',
  validateUuidParam('id'),
  asyncHandler(async (req, res) => {
    res.json(await conversations.deleteConversation(req.params.id));
  }),
);

/**
 * Ask a question. Streams Server-Sent Events by default; pass
 * `"stream": false` (or `Accept: application/json`) to receive a single JSON
 * response instead. Closing the connection aborts generation.
 */
router.post(
  '/conversations/:id/messages',
  validateUuidParam('id'),
  validateBody(askSchema),
  asyncHandler(async (req, res) => {
    const body = req.validated;
    const wantsStream = body.stream !== false && req.get('accept') !== 'application/json';
    // Cross-project search is limited to the projects this user may read.
    const allowedProjectIds = await access.allowedProjectIds(req.user);

    if (!wantsStream) {
      const result = await conversations.ask({
        conversationId: req.params.id,
        question: body.question,
        options: { ...body, stream: false, allowedProjectIds },
      });
      return res.json({ result });
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const controller = new AbortController();
    let closed = false;
    // Listen on the *response*, not the request: the request's 'close' event
    // fires as soon as the request body has been consumed, which would suppress
    // every event we try to stream back. The response 'close' fires only when
    // the client actually disconnects or the response finishes.
    res.on('close', () => {
      if (!closed) {
        closed = true;
        controller.abort();
      }
    });

    const emit = (event) => {
      if (res.writableEnded || closed) return;
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        /* client went away */
      }
    };

    try {
      const result = await conversations.ask({
        conversationId: req.params.id,
        question: body.question,
        options: { ...body, stream: true, allowedProjectIds },
        emit,
        signal: controller.signal,
      });
      emit({ type: 'complete', ok: result.ok, messageId: result.messageId, code: result.code });
    } catch (err) {
      emit({ type: 'error', code: err.code || 'generation_failed', message: err.message });
    } finally {
      closed = true;
      if (!res.writableEnded) res.end();
    }
  }),
);

/** Retrieval-only endpoint used by the "inspect evidence" panel. */
router.post(
  '/conversations/:id/evidence',
  validateUuidParam('id'),
  validateBody(
    z.object({
      question: z.string().trim().min(1).max(8000),
      crossProject: z.boolean().optional().default(false),
      projectIds: z.array(z.string().uuid()).max(50).optional(),
      retrieval: retrievalSchema.optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const conversation = req.conversation;
    const result = await conversations.retrieveEvidence({
      projectId: conversation.project_id,
      question: req.validated.question,
      options: {
        crossProject: req.validated.crossProject,
        projectIds: req.validated.projectIds,
        retrieval: req.validated.retrieval,
        allowedProjectIds: await access.allowedProjectIds(req.user),
      },
    });
    res.json({ sources: result.sources, stats: result.stats });
  }),
);

router.get(
  '/conversations/:id/messages',
  validateUuidParam('id'),
  validateQuery(z.object({ limit: z.coerce.number().int().min(1).max(500).optional() })),
  asyncHandler(async (req, res) => {
    const conversation = await conversations.getConversation(req.params.id);
    res.json({ messages: conversation.messages, sources: conversation.sources });
  }),
);

module.exports = router;

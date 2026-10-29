'use strict';

/**
 * Backwards-compatible import path.
 *
 * Storage now lives behind an adapter in services/storage so production can use
 * Supabase Storage while development and tests keep using local disk.
 */
module.exports = require('../services/storage');

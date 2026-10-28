import express from 'express';
const router = express.Router();
// Compatibility discovery for existing clients; no extension code is loaded.
router.get('/', (_req, res) => res.json({ data: [] }));
export default router;

// 2026-08-20 ZYPPAR-STYLE UPDATE CONTROLLER (verbatim from zypparserver).
const updateService = require('../services/updates.service.js');

const updateController = {
  getUpdateStatus,
};

async function getUpdateStatus(req, res, next) {
  try {
    const clientVersion = req.query.clientVersion;
    const status = await updateService.getUpdateStatus(clientVersion);
    res.set({
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      'Pragma': 'no-cache',
      'Expires': '0',
      'ETag': `W/"${Date.now()}"`,
    });
    res.json(status);
  } catch (err) {
    next(err);
  }
}

module.exports = updateController;

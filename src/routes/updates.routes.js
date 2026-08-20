// 2026-08-20 ZYPPAR-STYLE UPDATE ROUTES (verbatim from zypparserver).
const express = require('express');
const updateController = require('../controllers/updates.controller.js');

const updateRouter = express.Router();

updateRouter.get('/check', updateController.getUpdateStatus);

module.exports = updateRouter;

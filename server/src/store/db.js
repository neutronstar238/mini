'use strict';
/** Repository 存储层全局实例（app 启动时初始化，驱动由环境变量切换） */
const { createCollections } = require('./sqliteStore');
const config = require('../config');

const db = createCollections(config.dataDir);
module.exports = db;

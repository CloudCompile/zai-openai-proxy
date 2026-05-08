'use strict';

const { getModels } = require('./_lib');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).end();
  }

  try {
    const ids = await getModels();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).end(
      JSON.stringify({
        object: 'list',
        data: ids.map(id => ({ id, object: 'model', created: 1700000000, owned_by: 'zhipu' })),
      })
    );
  } catch (e) {
    console.error('[-] Error:', e.message);
    res.setHeader('Content-Type', 'application/json');
    res.status(500).end(JSON.stringify({ error: { message: e.message } }));
  }
};

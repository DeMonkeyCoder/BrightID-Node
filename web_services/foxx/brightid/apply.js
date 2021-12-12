'use strict';
const createRouter = require('@arangodb/foxx/router');
const joi = require('joi');
const { db: arango, ArangoError } = require('@arangodb');
const nacl = require('tweetnacl');
const db = require('./db');
const operations = require('./operations');
const schemas = require('./schemas');
const errors = require('./errors');

const router = createRouter();
module.context.use(router);
const operationsHashesColl = arango._collection('operationsHashes');

const handlers = {
  operationsPut: function(req, res){
    const op = req.body;
    const hash = req.param('hash');
    op.hash = hash;
    try {
      if (operationsHashesColl.exists(op.hash)) {
        throw new errors.OperationAppliedBeforeError(op.hash);
      }
      operations.verify(op);
      op.result = operations.apply(op);
      op.state = 'applied';
      operationsHashesColl.insert({ _key: op.hash });
    } catch (e) {
      op.state = 'failed';
      if (e instanceof ArangoError) {
        e.arangoErrorNum = e.errorNum;
        e.errorNum = errors.ARANGO_ERROR;
      }
      op.result = {
        message: e.message || e,
        stack: !(e instanceof errors.BrightIDError) ? e.stack : undefined,
        errorNum: e.errorNum,
        arangoErrorNum: e.arangoErrorNum,
      };
    }
    db.upsertOperation(op);
    res.send({'success': true, 'state': op.state, 'result': op.result});
  }
};

// add blockTime to operation schema
schemas.schemas.operation = joi.alternatives().try(
  Object.values(schemas.operations).map(op => {
    op.blockTime = joi.number().required().description('milliseconds since epoch when the block was created');
    return joi.object(op);
  })
).description('Send operations to idchain to be applied to BrightID nodes\' databases after consensus');

router.put('/operations/:hash', handlers.operationsPut)
  .pathParam('hash', joi.string().required().description('sha256 hash of the operation message'))
  .body(schemas.schemas.operation)
  .summary('Apply operation after consensus')
  .description("Apply operation after consensus.")
  .response(null);

module.context.use(function (req, res, next) {
  try {
    next();
  } catch (e) {
    if (e.cause && e.cause.isJoi && e.cause.details && e.cause.details.length  > 0){
      e.code = 400;
      let msg1 = '';
      let msg2 = `${e.cause.details[0]['path'][0]} must be one of the `;
      e.cause.details.forEach(d => {
        if (["any.required", "object.allowUnknown"].includes(d.type)) {
          console.log('$$$', d.message);
          msg1 += `, ${d.message}`;
        } else if (d.type == "any.allowOnly") {
          msg2 += `${d["context"]["valids"][0]}, `;
        }
      });
      e.message = msg1 || msg2;
      console.group("Error returned");
      console.log('url:', req._raw.requestType, req._raw.url);
      console.log('error:', e.message);
      console.log('body:', req.body);
      console.groupEnd();
      res.throw(e.code, e);
    }
    console.group("Error returned");
    console.log('url:', req._raw.requestType, req._raw.url);
    console.log('error:', e);
    console.log('body:', req.body);
    console.groupEnd();
    res.throw(e.code || 500, e);
  }
});

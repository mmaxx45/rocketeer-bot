const express = require('express');

// Express 4 does not pass rejected promises from async handlers to next(err):
// the request would hang until the socket times out. Route rejections (and
// synchronous throws) to the error handler instead.
function asyncHandler(fn) {
  return (req, res, next) => {
    try {
      const result = fn(req, res, next);
      if (result && typeof result.then === 'function') result.catch(next);
    } catch (err) {
      next(err);
    }
  };
}

// A Router whose route and middleware functions are all wrapped with
// asyncHandler, so a handler cannot forget it. Error middleware (four
// arguments) is left as is.
function asyncRouter(options) {
  const router = express.Router(options);
  const wrap = handler => (typeof handler === 'function' && handler.length < 4 ? asyncHandler(handler) : handler);
  const wrapArgs = args => args.map(arg => (Array.isArray(arg) ? arg.map(wrap) : wrap(arg)));
  for (const method of ['get', 'post', 'put', 'patch', 'delete', 'all', 'use']) {
    const original = router[method].bind(router);
    router[method] = (...args) => original(...wrapArgs(args));
  }
  return router;
}

module.exports = { asyncHandler, asyncRouter };

function safeRouter(router) {
  const wrap = fn => {
    if (Array.isArray(fn)) return fn.map(wrap);
    if (typeof fn !== 'function') return fn;
    if (fn.length === 4) return function (error, req, res, next) {
      try {
        Promise.resolve(fn(error, req, res, next)).catch(next);
      } catch (e) {
        next(e);
      }
    };
    return function (req, res, next) {
      try {
        Promise.resolve(fn(req, res, next)).catch(next);
      } catch (e) {
        next(e);
      }
    };
  };
  for (const method of ['use', 'get', 'post', 'put', 'patch', 'delete', 'all']) {
    const original = router[method];
    router[method] = function (...args) {
      if (method === 'get' && args.length === 1) return original.apply(this, args);
      return original.apply(this, args.map(wrap));
    };
  }
  return router;
}
module.exports = {
  safeRouter
};

const path = require('node:path');
function iconAsset(web, pathname) {
  return path.resolve(web, '.' + pathname);
}
module.exports = {iconAsset};

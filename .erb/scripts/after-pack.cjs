const patchLibsql = require('./patch-libsql.cjs')
const runtimeDeps = require('./runtime-deps.cjs')

exports.default = async function afterPack(context) {
  await patchLibsql.default(context)
  runtimeDeps.ensureUnpackedRuntimeDeps(context)
  await runtimeDeps.default(context)
}

// Local candidates remain integrity-checked, but cannot be published to npm.
export function localIdentity(manifest, release, revision, platform) {
  if (!/^[a-f0-9]{40}$/.test(revision) || !Object.hasOwn(release.platforms,platform)) {
    throw new Error('Local package requires a full source commit and supported platform');
  }
  const version = `${manifest.version.split('-')[0]}-local.g${revision.slice(0,12)}`;
  return {
    manifest:{...manifest,version,private:true,optionalDependencies:{[`@fireside-dev/${platform}`]:version}},
    release:{...release,engineRevision:revision,platforms:{[platform]:release.platforms[platform]},
      localDevelopment:true},
  };
}

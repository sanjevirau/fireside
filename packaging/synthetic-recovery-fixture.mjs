// Unit-test model only: these identities do not refer to a real release or run.
// Production recovery still requires an independently reviewed version receipt.
export function syntheticRecoveryFixture() {
  const version='0.0.0-synthetic.0',sourceRun=12345,sourceCommit='1'.repeat(40);
  const platforms=['darwin-arm64','darwin-x64','linux-arm64','linux-x64','win32-x64'];
  const artifacts=platforms.map((name,i)=>({id:i+1,name,digest:`sha256:${String(i+2).repeat(64)}`}));
  const packages=[...platforms,'cli'].map(name=>({name:`@fireside-dev/${name}`,sha256:'a'.repeat(64),integrity:'sha512-synthetic'}));
  const receipt={schemaVersion:1,version,tag:`npm-v${version}`,engineRevision:'2'.repeat(40),sourceRun,sourceAttempt:1,sourceCommit,artifacts,packages,accepted:[]};
  const names=['authorize','artifacts / verify','quality / Rust quality gate','quality / Public fixture and package checks','quality / Differential harness',...platforms.map(name=>`artifacts / Packed install (${name})`),...['memory','disk-wal'].flatMap(mode=>['memory','persistence'].map(client=>`quality / Firebase JS SDK browser integration (${mode}, client ${client})`))];
  const fixture={run:{id:sourceRun,run_attempt:1,head_sha:sourceCommit,head_branch:'main',repository:{full_name:'sanjevirau/fireside'},path:'.github/workflows/release-npm.yml',event:'workflow_dispatch',status:'completed',conclusion:'failure'},jobs:[...names.map(name=>({name,conclusion:'success'})),{name:'publish',conclusion:'failure'}],artifacts:artifacts.map(artifact=>({...artifact,expired:false,workflow_run:{id:sourceRun,head_sha:sourceCommit,repository_id:1,head_repository_id:1}}))};
  return {receipt,fixture};
}

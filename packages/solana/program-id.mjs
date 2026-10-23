// The program's address as declared in its source (`declare_id!`). Upgrades need only this address, not the program
// keypair, which stays out of the repository.
export function declaredProgramId(source) {
  const match = /declare_id!\("([1-9A-HJ-NP-Za-km-z]{32,44})"\)/.exec(source);
  if (!match) throw new Error('The program source does not declare its address (declare_id!).');
  return match[1];
}

import { taskRequirements } from './routing.mjs';

export function parseTaskOptions(args) {
  const requirements = { target: 'current', dependsOn: [] };
  let index = 0;
  for (; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--') { index++; break; }
    if (argument === '--target') {
      if (!args[index + 1]) throw new Error('--target: current, windows или windows-gui.');
      requirements.target = args[++index];
    }
    else if (argument === '--after') requirements.dependsOn.push(args[++index]);
    else if (argument.startsWith('--')) throw new Error(`Неизвестный параметр add: ${argument}`);
    else break;
  }
  return { goal: args.slice(index).join(' '), requirements: taskRequirements(requirements) };
}

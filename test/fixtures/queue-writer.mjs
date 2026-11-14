import { addTask } from '../../src/store.mjs';
await addTask(`Concurrent process ${process.argv[3]}`, process.argv[2]);

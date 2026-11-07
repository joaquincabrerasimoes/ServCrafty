import { migrate } from './migrate.js';
import { closeDb } from './pool.js';

try {
  const applied = await migrate();
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date');
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await closeDb();
}

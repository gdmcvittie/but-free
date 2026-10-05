import { listJobs } from '../server/torrentNode.js';
try {
  const jobs = await listJobs();
  console.log('JOBS:', JSON.stringify(jobs.map(j => ({ id: j.id, userId: j.userId, title: j.title, status: j.status, percent: j.percent })), null, 2));
} catch (e) {
  console.error(e);
}

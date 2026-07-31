const { Worker } = require('bullmq');

new Worker('emails', async (job) => {
  await send(job.data);
});

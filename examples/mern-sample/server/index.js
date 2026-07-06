import cors from 'cors';
import express from 'express';
import mongoose from 'mongoose';

const PORT = process.env.PORT ?? 5000;
const MONGO_URL = process.env.MONGO_URL ?? 'mongodb://localhost:27017/orca';

const app = express();
app.use(cors());
app.use(express.json());

// A tiny model so the mongoose connection is actually exercised on each request.
const Visit = mongoose.model('Visit', new mongoose.Schema({ at: { type: Date, default: Date.now } }));

app.get('/api/hello', async (_req, res) => {
  let visits = null;
  if (mongoose.connection.readyState === 1) {
    await Visit.create({});
    visits = await Visit.countDocuments();
  }
  res.json({ message: 'hello from the ORCA express server', visits });
});

async function start() {
  try {
    await mongoose.connect(MONGO_URL);
    console.log(`connected to mongo at ${MONGO_URL}`);
  } catch (err) {
    // Don't crash the dev server if mongo isn't up yet — the route degrades gracefully.
    console.error('mongo connection failed:', err.message);
  }
  app.listen(PORT, () => console.log(`server listening on ${PORT}`));
}

start();

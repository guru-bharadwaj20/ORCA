import express from 'express';
import mongoose from 'mongoose';

const app = express();
const port = process.env.PORT || 3000;

await mongoose.connect(process.env.MONGO_URL || 'mongodb://localhost:27017/app');

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.listen(port, () => console.log(`listening on ${port}`));

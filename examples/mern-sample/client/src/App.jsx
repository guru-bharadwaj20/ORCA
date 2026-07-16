import { useEffect, useState } from 'react';

// The server URL is injected at build/run time; falls back to localhost for bare `npm run dev`.
const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:5000';

export default function App() {
  const [message, setMessage] = useState('loading…');
  const [visits, setVisits] = useState(null);

  useEffect(() => {
    fetch(`${API_URL}/api/hello`)
      .then((res) => res.json())
      .then((data) => {
        setMessage(data.message);
        setVisits(data.visits);
      })
      .catch(() => setMessage('failed to reach the API'));
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem' }}>
      <h1>ORCA MERN Sample</h1>
      <p>API says: {message}</p>
      {visits !== null && <p>Recorded visits (via MongoDB): {visits}</p>}
    </main>
  );
}

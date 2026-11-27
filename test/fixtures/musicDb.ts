// Deterministic sample database used by the unit tests and the browser harness.

export const MUSIC_SCHEMA = `
CREATE TABLE artists (id INTEGER PRIMARY KEY, name TEXT NOT NULL, country TEXT, formed INTEGER);
CREATE TABLE albums (id INTEGER PRIMARY KEY, artist_id INTEGER REFERENCES artists(id), title TEXT NOT NULL, released TEXT, label TEXT);
CREATE TABLE genres (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE tracks (
  id INTEGER PRIMARY KEY,
  album_id INTEGER REFERENCES albums(id),
  genre_id INTEGER REFERENCES genres(id),
  name TEXT NOT NULL,
  milliseconds INTEGER,
  unit_price REAL DEFAULT 0.99,
  metadata TEXT
);
CREATE INDEX idx_tracks_album ON tracks(album_id);
CREATE TABLE customers (id INTEGER PRIMARY KEY, first_name TEXT, last_name TEXT, email TEXT, country TEXT, created_at TEXT);
CREATE TABLE invoices (id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(id), invoice_date TEXT, total REAL);
CREATE TABLE invoice_items (
  invoice_id INTEGER REFERENCES invoices(id),
  track_id INTEGER REFERENCES tracks(id),
  quantity INTEGER,
  unit_price REAL,
  PRIMARY KEY (invoice_id, track_id)
) WITHOUT ROWID;
CREATE VIEW top_tracks AS
  SELECT t.name, a.title AS album, sum(i.quantity) AS sold
  FROM invoice_items i JOIN tracks t ON t.id = i.track_id JOIN albums a ON a.id = t.album_id
  GROUP BY t.id ORDER BY sold DESC LIMIT 20;
`;

function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const q = (s: string) => "'" + s.replace(/'/g, "''") + "'";

export function musicSql(trackCount = 1200): string {
  const rnd = prng(42);
  const pick = <T>(arr: T[]) => arr[Math.floor(rnd() * arr.length)];
  const out: string[] = [MUSIC_SCHEMA, 'BEGIN;'];
  const countries = ['US', 'GB', 'JM', 'DE', 'NG', 'BR', 'FR', 'JP', 'CL', 'ES'];
  const genres = ['Rock', 'Jazz', 'Reggae', 'Classical', 'Hip Hop', 'Electronic', 'Soul', 'Afrobeat'];
  genres.forEach((g, i) => out.push(`INSERT INTO genres VALUES (${i + 1}, ${q(g)});`));
  const words = ['Zombie', 'Fire', 'Home', 'City', 'River', 'Blue', 'Night', 'Water', 'Gold', 'Sun', 'Moon', 'Road'];
  for (let i = 1; i <= 16; i++) out.push(`INSERT INTO artists VALUES (${i}, ${q('Artist ' + i)}, ${q(pick(countries))}, ${1960 + Math.floor(rnd() * 60)});`);
  for (let i = 1; i <= 48; i++) {
    out.push(`INSERT INTO albums VALUES (${i}, ${1 + (i % 16)}, ${q(pick(words) + ' ' + pick(words).toLowerCase())}, '${1970 + Math.floor(rnd() * 50)}-0${1 + (i % 9)}-1${i % 9}', ${q('Label ' + (i % 5))});`);
  }
  for (let i = 1; i <= trackCount; i++) {
    const meta = rnd() < 0.3 ? q(JSON.stringify({ bpm: 80 + Math.floor(rnd() * 80), explicit: rnd() < 0.5 })) : 'NULL';
    out.push(
      `INSERT INTO tracks VALUES (${i}, ${1 + Math.floor(rnd() * 48)}, ${1 + Math.floor(rnd() * 8)}, ${q(pick(words) + ' ' + pick(words).toLowerCase())}, ${150000 + Math.floor(rnd() * 300000)}, ${pick([0.99, 1.29, 1.99])}, ${meta});`,
    );
  }
  const first = ['Mia', 'Sofia', 'Tunde', 'Ana', 'Liam', 'Noah', 'Emma', 'Ava', 'Lucas', 'Chidi'];
  const last = ['Smith', 'García', 'Okafor', 'Müller', 'Silva', 'Brown', 'Tanaka', 'Rossi'];
  for (let i = 1; i <= 60; i++) {
    const f = pick(first);
    const l = pick(last);
    out.push(
      `INSERT INTO customers VALUES (${i}, ${q(f)}, ${q(l)}, ${q(`${f}.${l}${i}@example.com`.toLowerCase())}, ${q(pick(countries))}, '2025-0${1 + (i % 9)}-1${i % 9} 1${i % 9}:2${i % 6}:00');`,
    );
  }
  let items = 0;
  for (let i = 1; i <= 200; i++) {
    out.push(`INSERT INTO invoices VALUES (${i}, ${1 + Math.floor(rnd() * 60)}, '2026-0${1 + (i % 9)}-0${1 + (i % 9)}', 0);`);
    const used = new Set<number>();
    const n = 1 + Math.floor(rnd() * 3);
    for (let j = 0; j < n && items < 378; j++) {
      const track = 1 + Math.floor(rnd() * trackCount);
      if (used.has(track)) continue;
      used.add(track);
      items++;
      out.push(`INSERT INTO invoice_items VALUES (${i}, ${track}, ${1 + Math.floor(rnd() * 2)}, ${pick([0.99, 1.29, 1.99])});`);
    }
  }
  out.push('UPDATE invoices SET total = (SELECT round(coalesce(sum(quantity * unit_price), 0), 2) FROM invoice_items WHERE invoice_id = invoices.id);');
  out.push('COMMIT;');
  return out.join('\n');
}

// The Studio Ghibli films API as a Slime API source: an app-defined source in
// about 30 lines (core/docs/multi-source.md §4.1). Public and keyless; it
// filters on the server and returns numbers as strings, which run() converts.
import { defineApiSource } from '@slime-cloud/core';

const BASE_URL = 'https://ghibliapi.vercel.app';

/** `fetchImpl` lets tests replay recorded responses instead of calling the API. */
export function ghibliFilms({ fetchImpl } = {}) {
  return defineApiSource({
    name: 'ghibli',
    service: 'Studio Ghibli API (public, read-only)',
    baseUrl: BASE_URL,
    ...(fetchImpl ? { fetchImpl } : {}),
    operations: {
      'films.list': {
        description: 'Studio Ghibli feature films',
        params: { director: { type: 'string', comment: 'exact director name, for example Hayao Miyazaki' } },
        columns: { id: 'string', title: 'string', director: 'string', releaseYear: 'integer', runningTimeMin: 'integer', rtScore: 'integer' },
        primaryKey: ['id'],
        async run({ director }, { http }) {
          const films = await http.getJson('/films', { director });
          return films.map((film) => ({
            id: film.id,
            title: film.title,
            director: film.director,
            releaseYear: Number(film.release_date),
            runningTimeMin: Number(film.running_time),
            rtScore: Number(film.rt_score),
          }));
        },
      },
    },
    check: async ({ http }) => {
      await http.getJson('/films', { limit: 1 });
    },
  });
}

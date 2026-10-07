import type { Creator } from './domain/types.js';

/** Cadastro fictício usado em desenvolvimento e nos exemplos do README. */
export const seedCreators: Creator[] = [
  {
    id: 'ana',
    name: 'Ana Lima',
    coupons: ['ANA10'],
    utmContent: 'ana',
  },
  {
    id: 'bruno',
    name: 'Bruno Dias',
    coupons: ['BRUNO15'],
    utmContent: 'bruno',
  },
];

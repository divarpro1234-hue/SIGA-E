// Carga de los componentes de demostración. Solo existen en desarrollo: bajo import.meta.env.DEV
// el bundler sustituye la condición por false y elimina el import dinámico y todo el módulo demo.
import { lazy } from 'react';

export const CasosDemo = import.meta.env.DEV ? lazy(() => import('../demo/CasosDemo')) : null;
export const ListaDemo = import.meta.env.DEV ? lazy(() => import('../demo/ListaDemo')) : null;
export const BandejaDemo = import.meta.env.DEV ? lazy(() => import('../demo/BandejaDemo')) : null;

import { createContext } from 'react';

export type SheetHeight = 'peek' | 'half' | 'full';
/** Lets a card inside the bottom sheet lower or raise it; outside a sheet (laptop and desktop) it does nothing. */
export const SheetContext = createContext<(h: SheetHeight) => void>(() => undefined);

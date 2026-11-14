import { createContext, useContext } from "react";
import type { Settings } from "./types.js";

/** The server's settings, once loaded: the account, the network, the public address. Undefined until they arrive. */
export const SettingsContext = createContext<Settings | undefined>(undefined);
export const useSettings = () => useContext(SettingsContext);

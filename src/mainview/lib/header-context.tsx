import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

interface HeaderContextValue {
  headerActions: ReactNode;
  setHeaderActions: (actions: ReactNode) => void;
}

const HeaderContext = createContext<HeaderContextValue>({
  headerActions: null,
  setHeaderActions: () => {},
});

export function HeaderProvider({ children }: { children: ReactNode }) {
  const [headerActions, setHeaderActionsState] = useState<ReactNode>(null);
  const setHeaderActions = useCallback((actions: ReactNode) => {
    setHeaderActionsState(actions);
  }, []);
  return (
    <HeaderContext.Provider value={{ headerActions, setHeaderActions }}>
      {children}
    </HeaderContext.Provider>
  );
}

/**
 * Register right-side action buttons in the top navigation bar.
 *
 * Pass a factory function (to avoid stale-closure issues with JSX objects)
 * and a deps array — the actions are re-created whenever deps change and
 * cleared automatically when the calling component unmounts.
 *
 * @example
 * useHeaderActions(
 *   () => <Button onClick={() => setOpen(true)}><Plus /> New Item</Button>,
 *   [], // stable — setOpen never changes
 * );
 *
 * @example // stateful button (e.g. loading spinner)
 * useHeaderActions(
 *   () => <Button disabled={loading} onClick={handleSave}>Save</Button>,
 *   [loading],
 * );
 */
/**
 * Register right-side action buttons in the top navigation bar.
 *
 * `deps` controls WHEN the actions are re-registered (i.e. when the rendered
 * output changes — typically loading/disabled flags). The factory itself is
 * stored in a ref so click handlers always close over the latest state even
 * when they are not listed in deps.
 *
 * Rule of thumb: only put primitive state values in deps (booleans, strings,
 * numbers). Never put plain function declarations — they create new references
 * on every render and cause infinite update loops via the context.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useHeaderActions(factory: () => ReactNode, deps: unknown[]) {
  const { setHeaderActions } = useContext(HeaderContext);
  // Keep a ref to the latest factory so handlers are never stale, regardless
  // of what the caller puts in deps.
  const factoryRef = useRef(factory);
  factoryRef.current = factory;

  useEffect(() => {
    setHeaderActions(factoryRef.current());
    return () => setHeaderActions(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

// eslint-disable-next-line react-refresh/only-export-components
export function useHeaderContext() {
  return useContext(HeaderContext);
}

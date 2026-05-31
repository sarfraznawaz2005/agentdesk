import { useEffect } from "react";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import { initTheme, syncThemeFromDB } from "./lib/theme";

initTheme(); // synchronous — runs before render, no flash

function App() {
  useEffect(() => {
    syncThemeFromDB();
  }, []);

  return <RouterProvider router={router} />;
}

export default App;

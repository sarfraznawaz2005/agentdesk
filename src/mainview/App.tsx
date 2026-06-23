import { useEffect } from "react";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import { initTheme, syncThemeFromDB } from "./lib/theme";
import { initBackground, syncBackgroundFromDB } from "./lib/app-background";

initTheme(); // synchronous — runs before render, no flash
initBackground(); // synchronous — runs before render, no flash

function App() {
  useEffect(() => {
    syncThemeFromDB();
    syncBackgroundFromDB();
  }, []);

  return <RouterProvider router={router} />;
}

export default App;

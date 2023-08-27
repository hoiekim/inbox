import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, callUser } from "client";

import "./index.scss";

const root = createRoot(document.getElementById("root") as HTMLElement);

const mountApp = async () => {
  const user = await callUser();
  root.render(
    <StrictMode>
      <App user={user} />
    </StrictMode>
  );
};

mountApp();

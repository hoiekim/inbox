import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, getUser } from "client";

import "./index.scss";

const root = createRoot(document.getElementById("root") as HTMLElement);

const mountApp = async () => {
  const user = await getUser();
  root.render(
    <StrictMode>
      <App user={user} />
    </StrictMode>
  );
};

mountApp();

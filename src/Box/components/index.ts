import React from "react";

export const Writer = React.lazy(() => import("./Writer"));
export const Mails = React.lazy(() => import("./Mails"));
export const Accounts = React.lazy(() => import("./Accounts"));

export { default as FileIcon } from "./FileIcon";

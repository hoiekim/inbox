import React from "react";
import Writer from "./components/Writer";
import "./index.scss";

const Box = () => {
  return (
    <div className="container-wrap">
      <div id="container">
        <Writer />
        <div id="container-accounts" className="container"></div>
        <div id="container-mails" className="container"></div>
      </div>
    </div>
  );
};

export default Box;

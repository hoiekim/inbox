import React, { useContext } from "react";
import Writer from "./components/Writer";
import Accounts from "./components/Accounts";
import Mails from "./components/Mails";
import { Context } from "..";
import "./index.scss";

const Box = () => {
  const {
    viewSize,
    isAccountsOpen,
    setIsAccountsOpen,
    isWriterOpen,
    setIsWriterOpen
  } = useContext(Context);

  const onClickCurtain = () => {
    setIsWriterOpen(false);
    if (!isWriterOpen) setIsAccountsOpen(false);
  };

  const mainPaneStyle = {};
  const sidePaneStyle = { width: "300px" };
  const writerStyle = {};

  if (viewSize.width > 900) {
    mainPaneStyle.width = "calc(100vw - 420px)";
    mainPaneStyle.left = "302px";
    sidePaneStyle.left = 0;
    writerStyle.width = "calc(100vw - 400px)";
  } else if (viewSize.width > 750) {
    mainPaneStyle.width = "calc(100vw - 302px)";
    mainPaneStyle.left = "302px";
    sidePaneStyle.left = 0;
    writerStyle.width = "calc(100vw - 3rem)";
  } else {
    mainPaneStyle.width = "100vw";
    mainPaneStyle.left = 0;
    mainPaneStyle.padding = "0 0.5rem";
    writerStyle.width = "calc(100vw - 3rem)";
  }

  if (isAccountsOpen) {
    mainPaneStyle.left = "302px";
    sidePaneStyle.left = 0;
  } else {
    if (viewSize.width > 900) {
      mainPaneStyle.width = "calc(100vw - 118px)";
      mainPaneStyle.left = 0;
    } else if (viewSize.width > 750) {
      mainPaneStyle.width = "100vw";
      mainPaneStyle.left = 0;
    }
    sidePaneStyle.left = "-300px";
  }

  if (isWriterOpen) {
    writerStyle.right = 0;
  } else if (viewSize.width > 900) {
    writerStyle.right = "calc(500px - 100vw)";
  } else {
    writerStyle.right = "calc(3rem - 100vw)";
  }

  return (
    <>
      <div style={sidePaneStyle} className="pane side_pane">
        <div
          style={sidePaneStyle}
          className={isWriterOpen ? "curtain on" : "curtain"}
          onClick={onClickCurtain}
        />
        <Accounts />
      </div>
      <div style={mainPaneStyle} className="pane main_pane">
        <div
          style={mainPaneStyle}
          className={
            isWriterOpen
              ? "curtain on"
              : isAccountsOpen && viewSize.width < 750
              ? "curtain on"
              : "curtain"
          }
          onClick={onClickCurtain}
        />
        <Mails />
      </div>
      <div
        style={writerStyle}
        className={isWriterOpen ? "writer_pane shadow" : "writer_pane"}
      >
        <Writer />
      </div>
    </>
  );
};

export default Box;

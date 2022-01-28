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

  const mainPaneStyle = { height: viewSize.height - 55 + "px" };
  const sidePaneStyle = { width: "350px", height: viewSize.height + "px" };
  const writerStyle = {
    width: "calc(100vw - 1rem)",
    height: viewSize.height - 65 + "px"
  };

  if (viewSize.width > 1050) {
    mainPaneStyle.width = "calc(100vw - 470px)";
    mainPaneStyle.left = "352px";
    sidePaneStyle.left = 0;
  } else if (viewSize.width > 750) {
    mainPaneStyle.width = "calc(100vw - 252px)";
    mainPaneStyle.left = "352px";
    sidePaneStyle.left = 0;
  } else {
    mainPaneStyle.width = "100vw";
    mainPaneStyle.left = 0;
    mainPaneStyle.padding = "5px 0 0 0";
    writerStyle.width = "100vw";
  }

  if (isAccountsOpen) {
    mainPaneStyle.left = "352px";
    sidePaneStyle.left = 0;
    if (viewSize.width <= 1050 && viewSize.width > 750) {
      mainPaneStyle.left = "252px";
      sidePaneStyle.width = "250px";
    }
  } else {
    if (viewSize.width > 1050) {
      mainPaneStyle.width = "calc(100vw - 118px)";
      mainPaneStyle.left = 0;
    } else if (viewSize.width > 750) {
      mainPaneStyle.width = "100vw";
      mainPaneStyle.left = 0;
    }
    sidePaneStyle.left = "-350px";
  }

  if (isWriterOpen) {
    writerStyle.right = 0;
  } else if (viewSize.width > 1050) {
    writerStyle.right = "calc(115px - min(100vw, 900px))";
  } else {
    writerStyle.right = "-100vw";
  }

  return (
    <>
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
      <div style={sidePaneStyle} className="pane side_pane">
        <div
          style={sidePaneStyle}
          className={isWriterOpen ? "curtain on" : "curtain"}
          onClick={onClickCurtain}
        />
        <Accounts />
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

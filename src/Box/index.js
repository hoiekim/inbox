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

  const onClickMainOrSideCurtain = () => {
    if (!isWriterOpen) setIsAccountsOpen(false);
    setIsWriterOpen(false);
  };

  const onClickWriterCurtain = () => setIsWriterOpen(true);

  const mainPaneStyle = {};
  const sidePaneStyle = {};
  const writerStyle = { width: "calc(100vw - 1rem + 50px)" };

  if (viewSize.width > 1050) {
    sidePaneStyle.width = 400;

    if (isAccountsOpen) {
      mainPaneStyle.width = "calc(100vw - 470px)";
      mainPaneStyle.left = 350;
      sidePaneStyle.left = -50;
    } else {
      mainPaneStyle.width = "calc(100vw - 120px)";
      mainPaneStyle.left = 0;
      sidePaneStyle.left = -400;
    }

    if (isWriterOpen) writerStyle.right = -50;
    else writerStyle.right = "calc(65px - min(100vw, 900px))";
  } else if (viewSize.width > 750) {
    sidePaneStyle.width = 300;

    if (isAccountsOpen) {
      mainPaneStyle.width = "calc(100vw - 250px)";
      mainPaneStyle.left = 250;
      sidePaneStyle.left = -50;
    } else {
      mainPaneStyle.width = "100vw";
      mainPaneStyle.left = 0;
      sidePaneStyle.left = -300;
    }

    if (isWriterOpen) writerStyle.right = -50;
    else writerStyle.right = "calc(-100vw - 50px)";
  } else {
    sidePaneStyle.width = 400;
    mainPaneStyle.width = "100vw";
    writerStyle.width = "calc(100vw + 50px)";

    if (isAccountsOpen) {
      mainPaneStyle.left = 350;
      sidePaneStyle.left = -50;
    } else {
      mainPaneStyle.left = 0;
      mainPaneStyle.padding = "5px 0 0 0";
      sidePaneStyle.left = -400;
    }

    if (isWriterOpen) writerStyle.right = -50;
    else writerStyle.right = "calc(-100vw - 50px)";
  }

  return (
    <>
      <div style={mainPaneStyle} className="pane main_pane">
        <div
          className={
            isWriterOpen
              ? "curtain on"
              : isAccountsOpen && viewSize.width < 750
              ? "curtain on"
              : "curtain"
          }
          onClick={onClickMainOrSideCurtain}
        />
        <Mails />
      </div>
      <div style={sidePaneStyle} className="pane side_pane">
        <div
          className={"curtain" + (isWriterOpen ? " on" : "")}
          onClick={onClickMainOrSideCurtain}
        />
        <Accounts />
      </div>
      <div
        style={writerStyle}
        className={"pane writer_pane" + (isWriterOpen ? " shadow" : "")}
      >
        <div
          className={"curtain" + (isWriterOpen ? "" : " on")}
          onClick={onClickWriterCurtain}
        />
        <Writer />
      </div>
    </>
  );
};

export default Box;

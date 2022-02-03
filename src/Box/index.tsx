import React, { Suspense, useContext, useState } from "react";
import { Writer, Accounts, Mails } from "./components";
import { Context } from "src";
import "./index.scss";

const touchStartPosition = { x: 0, y: 0 };

const Box = () => {
  const {
    viewSize,
    isAccountsOpen,
    setIsAccountsOpen,
    isWriterOpen,
    setIsWriterOpen
  } = useContext(Context);

  const [swipeAmount, setSwipeAmount] = useState(0);

  const onClickMainOrSideCurtain = () => {
    if (!isWriterOpen) setIsAccountsOpen(false);
    setIsWriterOpen(false);
  };

  const onClickWriterCurtain = () => setIsWriterOpen(true);

  const isWriterOpening = !isAccountsOpen && swipeAmount < 0;
  const isAccountsClosing = !isWriterOpen && swipeAmount < 0;
  const isAccountsOpening = !isWriterOpen && swipeAmount > 0;

  const mainPaneStyle: any = { height: viewSize.height - 55, left: 0 };
  const sidePaneStyle: any = { height: viewSize.height - 55, left: -50 };
  const writerStyle: any = { height: viewSize.height - 55, right: -50 };

  let swipeOpenAccounts: boolean;
  let swipeCloseAccounts: boolean;
  let swipeOpenWriter: boolean;
  let swipeCloseWriter: boolean;

  let sidePaneLimit: number;
  let mainPaneLimit: number;
  let writerLimit: number;

  if (swipeAmount) {
    mainPaneStyle.transition = "none";
    sidePaneStyle.transition = "none";
    writerStyle.transition = "none";
  }

  if (viewSize.width > 1050) {
    mainPaneStyle.width = viewSize.width - 120;
    sidePaneStyle.width = 400;
    writerStyle.width = viewSize.width - 16 + 50;
    sidePaneLimit = 350;
    mainPaneLimit = 350;
    writerLimit = Math.min(viewSize.width, 900) - 115;
  } else if (viewSize.width > 750) {
    mainPaneStyle.width = viewSize.width;
    sidePaneStyle.width = 300;
    writerStyle.width = viewSize.width - 16 + 50;
    sidePaneLimit = 250;
    mainPaneLimit = 250;
    writerLimit = Math.min(viewSize.width, 900);
  } else {
    mainPaneStyle.padding = "5px 0 0 0";
    mainPaneStyle.width = viewSize.width;
    sidePaneStyle.width = 400;
    writerStyle.width = viewSize.width + 50;
    sidePaneLimit = 350;
    mainPaneLimit = 0;
    writerLimit = viewSize.width;
  }

  if (isAccountsOpen) {
    mainPaneStyle.width -= mainPaneLimit;
    mainPaneStyle.left += sidePaneLimit;
    if (isAccountsClosing) {
      const d_main = Math.max(-mainPaneLimit, swipeAmount);
      mainPaneStyle.width -= d_main;
      const d_side = Math.max(-sidePaneLimit, swipeAmount);
      mainPaneStyle.left += d_side;
      sidePaneStyle.left += d_side;
      if (swipeAmount < -sidePaneLimit / 3) swipeCloseAccounts = true;
    }
  } else {
    sidePaneStyle.left -= sidePaneLimit;
    if (isAccountsOpening) {
      const d_main = Math.min(mainPaneLimit, swipeAmount);
      mainPaneStyle.width -= d_main;
      const d_side = Math.min(sidePaneLimit, swipeAmount);
      mainPaneStyle.left += d_side;
      sidePaneStyle.left += d_side;
      if (swipeAmount > sidePaneLimit / 3) swipeOpenAccounts = true;
    }
  }

  if (isWriterOpen) {
    if (swipeAmount > 0) {
      writerStyle.right -= Math.min(writerLimit, swipeAmount);
      if (swipeAmount > Math.min(writerLimit / 3, 150)) {
        swipeCloseWriter = true;
      }
    }
  } else {
    writerStyle.right -= writerLimit;
    if (isWriterOpening) {
      writerStyle.right -= Math.max(-writerLimit, swipeAmount);
      if (swipeAmount < Math.max(-writerLimit / 3, -150)) {
        swipeOpenWriter = true;
      }
    }
  }

  const onPaneTouchStart: React.TouchEventHandler<HTMLDivElement> = (e) => {
    touchStartPosition.x = e.changedTouches[0]?.clientX;
    touchStartPosition.y = e.changedTouches[0]?.clientY;
  };

  const onPaneTouchMove: React.TouchEventHandler<HTMLDivElement> = (e) => {
    const { x, y } = touchStartPosition;
    const newX = e.changedTouches[0]?.clientX;
    const newY = e.changedTouches[0]?.clientY;
    const gradient = (newY - y) / (newX - x);
    if (0.5 < gradient || gradient < -0.5) setSwipeAmount(0);
    else setSwipeAmount(newX - x);
  };

  const onPaneTouchEnd: React.TouchEventHandler<HTMLDivElement> = () => {
    if (swipeOpenAccounts) setIsAccountsOpen(true);
    if (swipeCloseAccounts) setIsAccountsOpen(false);
    if (swipeOpenWriter) setIsWriterOpen(true);
    if (swipeCloseWriter) setIsWriterOpen(false);
    setSwipeAmount(0);
  };

  return (
    <>
      <div
        style={mainPaneStyle}
        className="pane main_pane"
        onTouchStart={onPaneTouchStart}
        onTouchMove={onPaneTouchMove}
        onTouchEnd={onPaneTouchEnd}
      >
        <div
          style={mainPaneStyle}
          className={
            "curtain" +
            (isWriterOpen ||
            (isAccountsOpen && viewSize.width <= 750) ||
            isWriterOpening
              ? " on"
              : "")
          }
          onClick={onClickMainOrSideCurtain}
        />
        <Suspense fallback={<></>}>
          <Mails />
        </Suspense>
      </div>
      <div
        style={sidePaneStyle}
        className="pane side_pane"
        onTouchStart={onPaneTouchStart}
        onTouchMove={onPaneTouchMove}
        onTouchEnd={onPaneTouchEnd}
      >
        <div
          style={sidePaneStyle}
          className={"curtain" + (isWriterOpen ? " on" : "")}
          onClick={onClickMainOrSideCurtain}
        />
        <Suspense fallback={<></>}>
          <Accounts />
        </Suspense>
      </div>
      <div
        style={writerStyle}
        className={"pane writer_pane" + (isWriterOpen ? " shadow" : "")}
        onTouchStart={onPaneTouchStart}
        onTouchMove={onPaneTouchMove}
        onTouchEnd={onPaneTouchEnd}
      >
        <div
          style={writerStyle}
          className={
            "curtain" + (!isWriterOpen && !isWriterOpening ? " on" : "")
          }
          onClick={onClickWriterCurtain}
        />
        <Suspense fallback={<></>}>
          <Writer />
        </Suspense>
      </div>
    </>
  );
};

export default Box;

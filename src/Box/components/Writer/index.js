import React, { useContext, useState } from "react";
import CcIcon from "./components/CcIcon";
import PreviewIcon from "./components/PreviewIcon";
import SendIcon from "./components/SendIcon";
import AttachIcon from "./components/AttachIcon";
import { Context } from "../../..";
import "./index.scss";

const domainName = process.env.REACT_APP_DOMAIN || "mydomain";

const Writer = () => {
  const { isWriterOpen, setIsWriterOpen } = useContext(Context);

  const swiperStyle = {};

  if (isWriterOpen) {
    swiperStyle.right = 0;
  } else swiperStyle.right = "calc(500px - 100vw)";

  const onClickCurtain = () => {
    setIsWriterOpen(true);
  };

  return (
    <blockquote className="writer" style={swiperStyle}>
      <div>
        <div className="fieldName">From: </div>
        <input id="writer-name" className="writer-short" placeholder="name" />
        <span className="helper-text"> &lt; </span>
        <input
          id="writer-from"
          className="writer-short"
          placeholder="account"
        />
        <span className="helper-text">@{domainName} &gt;</span>
      </div>
      <div>
        <div className="fieldName">
          <span>To: </span>
          <span>
            <CcIcon className="cursor" />
          </span>
        </div>
        <div className="inputBox-flex">
          <input
            id="writer-to"
            className="writer-long"
            placeholder="to@email.com"
          />
          <input
            id="writer-cc"
            className="writer-long hide"
            placeholder="cc@email.com"
            disabled
          />
          <input
            id="writer-bcc"
            className="writer-long hide"
            placeholder="bcc@email.com"
            disabled
          />
        </div>
      </div>
      <div>
        <div className="fieldName">Subject: </div>
        <input
          id="writer-title"
          className="writer-long"
          placeholder="This is the mail subject"
        />
      </div>
      <div className="writer-body">
        <div className="fieldName">
          <span>Content: </span>
          <span>
            <AttachIcon className="cursor" />
          </span>
        </div>
        <div id="writer-content-wrap">
          <div id="writer-content">
            <textarea
              id="writer-textarea"
              className="writer-fat"
              placeholder="Say something really cool here!"
            ></textarea>
            <iframe
              id="writer-preview"
              title="writer-preview"
              className="hide"
            ></iframe>
          </div>
        </div>
      </div>
      <div id="writer-buttons-wrap">
        <button id="writer-previewBtn" className="writer-buttons">
          <PreviewIcon className="cursor" />
          <span>Preview</span>
        </button>
        <button id="writer-send" className="writer-buttons">
          <SendIcon className="cursor" />
          <span>Send</span>
        </button>
      </div>
      <div
        style={{ left: "-3px" }}
        className={isWriterOpen ? "curtain" : "curtain on"}
        onClick={onClickCurtain}
      />
    </blockquote>
  );
};

export default Writer;

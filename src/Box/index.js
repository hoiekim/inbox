// import "../components/writer";
// import "../components/reader";

// document.getElementById("logout").addEventListener("click", () => {
//   fetch("/admin", { method: "DELETE" }).then((r) => {
//     location.href = "/";
//   });
// });

// document.getElementById("refresh").addEventListener("click", () => {
//   getMails();
// });

import React from "react";

const domainName = process.env.REACT_APP_DOMAIN || "My Domain";

const Box = () => {
  return (
    <>
      <div id="title_bar">
        <h1>{domainName} Mail</h1>
        <div id="buttons">
          <div id="write" class="iconBox">
            <i class="fas fa-pen cursor"></i>
          </div>
          <div id="refresh" class="iconBox">
            <i class="fas fa-sync-alt cursor"></i>
          </div>
          <div id="logout" class="iconBox">
            <i class="fas fa-sign-out-alt cursor"></i>
          </div>
        </div>
      </div>
      <div class="container-wrap">
        <div id="container">
          <blockquote id="container-writer" class="container clipped">
            <div>
              <div class="fieldName">From: </div>
              <input id="writer-name" class="writer-short" placeholder="name" />
              <span class="helper-text"> &lt; </span>
              <input
                id="writer-from"
                class="writer-short"
                placeholder="account"
              />
              <span class="helper-text">@{domainName} &gt;</span>
            </div>
            <div>
              <div class="fieldName">
                <span>To: </span>
                <span>
                  <i id="writer-eye" class="fas fa-eye cursor"></i>
                </span>
              </div>
              <div class="inputBox-flex">
                <input
                  id="writer-to"
                  class="writer-long"
                  placeholder="to@email.com"
                />
                <input
                  id="writer-cc"
                  class="writer-long hide"
                  placeholder="cc@email.com"
                  disabled
                />
                <input
                  id="writer-bcc"
                  class="writer-long hide"
                  placeholder="bcc@email.com"
                  disabled
                />
              </div>
            </div>
            <div>
              <div class="fieldName">Subject: </div>
              <input
                id="writer-title"
                class="writer-long"
                placeholder="This is the mail subject"
              />
            </div>
            <div>
              <div class="fieldName">
                <span>Content: </span>
                <span>
                  <i id="writer-paperclip" class="fas fa-paperclip cursor"></i>
                </span>
              </div>
              <div id="writer-body">
                <div id="writer-content-wrap">
                  <div id="writer-content">
                    <textarea
                      id="writer-textarea"
                      class="writer-fat"
                      placeholder="Say something really cool here!"
                    ></textarea>
                    <iframe id="writer-preview" class="hide"></iframe>
                  </div>
                </div>
              </div>
            </div>
            <div id="writer-buttons-wrap">
              <button id="writer-previewBtn" class="writer-buttons">
                <i class="fab fa-markdown cursor"></i>&nbsp;&nbsp;Preview
              </button>
              <button id="writer-send" class="writer-buttons">
                <i class="fas fa-paper-plane cursor"></i>&nbsp;&nbsp;Send
              </button>
            </div>
          </blockquote>
          <div id="container-accounts" class="container"></div>
          <div id="container-mails" class="container"></div>
        </div>
      </div>
    </>
  );
};

export default Box;

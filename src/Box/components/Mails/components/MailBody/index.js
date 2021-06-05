import React, { useState, useEffect } from "react";
import { useQuery } from "react-query";

import FileIcon from "../../../FileIcon";

const MailBody = ({ mailId }) => {
  const [iframeDom, setIframeDom] = useState(null);

  useEffect(() => {
    if (iframeDom) {
      iframeDom.addEventListener("load", () => {
        const iframeContent = iframeDom.contentWindow;
        const iframeContentHeight = iframeContent.document.body.scrollHeight;
        iframeDom.style.height = iframeContentHeight + 32 + "px";
      });
    }
  }, [iframeDom]);

  const getMail = () => {
    return fetch(`/api/mailContent/${mailId}`).then((r) => r.json());
  };
  const queryData = useQuery(`getMail_${mailId}`, getMail);

  if (queryData.isLoading) {
    return <div className="text">Loading Mail Data...</div>;
  }

  if (queryData.error) {
    return <div className="text">Mail Data Request Failed</div>;
  }

  const data = queryData.data;

  if (queryData.isSuccess && data) {
    const Attachments = () => {
      const result = data.attachments?.map((attachment, i) => {
        const onClickAttachment = () => {
          fetch(`/api/attachment/${attachment.content.data}`)
            .then((r) => r.arrayBuffer())
            .then((r) => {
              const link = document.createElement("a");
              const blob = new Blob([r], { type: attachment.contentType });
              const objectUrl = URL.createObjectURL(blob);
              link.href = objectUrl;
              link.target = "_black";
              link.download = attachment.filename;
              link.click();
            });
        };
        return (
          <div
            key={i}
            className="attachment cursor"
            onClick={onClickAttachment}
          >
            <FileIcon />
            <span>{attachment.filename}</span>
          </div>
        );
      });

      return <div className="attachmentBox">{result}</div> || <></>;
    };

    return (
      <div className="text">
        <Attachments />
        <iframe
          title={data.id}
          ref={(e) => e && setIframeDom(e)}
          srcDoc={`<style>
                body {
                    margin: 0;
                    overflow-y: hidden;
                }
                * {
                    font-family: "Open Sans", -apple-system, BlinkMacSystemFont, "Segoe UI",
                    "Roboto", "Oxygen", "Ubuntu", "Cantarell", "Fira Sans", "Droid Sans",
                    "Helvetica Neue", sans-serif;
                    color: rgb(70,70,70);
                }
            </style>
            ${queryData.data.html}`}
        />
      </div>
    );
  }
};

export default MailBody;

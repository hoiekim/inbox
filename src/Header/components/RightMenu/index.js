import React, { useContext } from "react";

import WriteIcon from "./components/WriteIcon";

import { Context } from "../../..";

const RightMenu = () => {
  const { isWriterOpen, setIsWriterOpen } = useContext(Context);

  const onClickWriter = () => {
    setIsWriterOpen(!isWriterOpen);
  };

  return (
    <div className="menu right">
      <div id="write" className="iconBox">
        <WriteIcon className="cursor" onClick={onClickWriter} />
      </div>
    </div>
  );
};

export default RightMenu;

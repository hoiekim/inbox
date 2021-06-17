import React, { useContext } from "react";

import WriteIcon from "./components/WriteIcon";

import { Context } from "../../..";

const RightMenu = () => {
  const { isWriterOpen, setIsWriterOpen } = useContext(Context);

  const onClickWriter = () => {
    setIsWriterOpen(!isWriterOpen);
  };

  return (
    <div className="menu right cursor" onClick={onClickWriter}>
      <div id="write" className="iconBox">
        <WriteIcon />
      </div>
    </div>
  );
};

export default RightMenu;

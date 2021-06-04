import React, { useState } from "react";
import Writer from "./components/Writer";
import Accounts from "./components/Accounts";
import Mails from "./components/Mails";
import "./index.scss";

const Box = () => {
  const [selectedAccount, setSelectedAccount] = useState("");

  return (
    <>
      <Accounts setSelectedAccount={setSelectedAccount} />
      <div className="main_pane pane">
        <Mails selectedAccount={selectedAccount} />
        <Writer />
      </div>
    </>
  );
};

export default Box;

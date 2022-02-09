export class Notification {
  constructor() {
    if ("setAppBadge" in navigator && "clearAppBadge" in navigator) {
      this.navigator = navigator;
    }
  }

  private navigator: any = {
    setAppBadge: async () => {},
    clearAppBadge: async () => {}
  };

  setBadge = (number: number) => {
    this.navigator.setAppBadge(number).catch(console.log);
  };

  clearBadge = () => {
    this.navigator.clearAppBadge().catch(console.log);
  };
}

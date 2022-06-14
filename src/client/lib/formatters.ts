export const getDateForMailHeader = (dateObject: Date) => {
  const date = dateObject.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric"
  });

  const time = dateObject.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit"
  });

  const d = (Date.now() - +dateObject) / (1000 * 60);
  let duration: string;

  if (d > 2 * 24 * 60 * 365) {
    duration = `${Math.floor(d / (60 * 24 * 365))} years ago`;
  } else if (d > 2 * 24 * 60 * 30.42) {
    duration = `${Math.floor(d / (60 * 24 * 30.42))} months ago`;
  } else if (d > 2 * 24 * 60 * 7) {
    duration = `${Math.floor(d / (60 * 24 * 7))} weeks ago`;
  } else if (d > 2 * 24 * 60) {
    duration = `${Math.floor(d / (60 * 24))} days ago`;
  } else if (d > 2 * 60) {
    duration = `${Math.floor(d / 60)} hours ago`;
  } else if (d > 2) {
    duration = `${Math.floor(d)} minutes ago`;
  } else {
    duration = "just now";
  }

  return { date, time, duration };
};

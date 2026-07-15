Promise.resolve("1").then((data) => console.log(data));

setTimeout(() => console.log("2"), 0);

console.log("3");

Promise.resolve("4").then((data) => console.log(data));

console.log("5");

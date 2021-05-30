const path = require('path');
const fs = require('fs')

const entry = {}

fs.readdirSync('./src').forEach((file) => {
    const splittedFilename = file.split(".")
    if (splittedFilename[splittedFilename.length - 1] === "js") {
        entry[file] = './src/' + file
    }
})

module.exports = {
  entry,
  output: {
    filename: '[name]',
    path: path.resolve(__dirname, 'dist'),
    clean: true
  },
};
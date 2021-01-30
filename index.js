// node-pdf

var Promise = require("es6-promise").Promise;

var path = require("path");
var fs = require("fs");
var util = require("util");
var exec = require("child_process").exec;

function PDFImage(pdfFilePath, options) {
  if (!options) options = {};

  this.pdfFilePath = pdfFilePath;

  this.setPdfFileBaseName(options.pdfFileBaseName);
  this.setConvertOptions(options.convertOptions);
  this.setConvertExtension(options.convertExtension);
  this.useGM = options.graphicsMagick || false;
  this.combinedImage = options.combinedImage || false;
  this.gutter = options.gutter || 50;
  this.ghostMargin = options.ghostMargin || 50;
  this.fuzzMargin = options.fuzzMargin || 1;
  this.overrideMargin = options.manual || 0;
  this.debug = options.debug || false;

  this.outputDirectory = options.outputDirectory || path.dirname(pdfFilePath);
}

PDFImage.prototype = {
  constructGetInfoCommand: function () {
    return util.format('pdfinfo "%s"', this.pdfFilePath);
  },
  parseGetInfoCommandOutput: function (output) {
    var info = {};
    output.split("\n").forEach(function (line) {
      if (line.match(/^(.*?):[ \t]*(.*)$/)) {
        info[RegExp.$1] = RegExp.$2;
      }
    });
    return info;
  },
  parseGetMarkerOutput: function (output) {
    var allMarkers = [];
    var margin = this.gutter;
    var ghostHeight = 10;

    // Output is of the form "h x y". where h is the height and
    // x,y are coordinates of the connected components.
    // Ignore any lines whose h is very small, as false positive
    // Find the minimum y value within a margin of given value
    // Not using the x value, but adding all the y points to an array
    output.split("\n").forEach(function (line) {
      if (line.match(/^(.*) (.*) (.*)$/)) {
        // Only consider the entry if it is not a ghost data
        if (parseInt(RegExp.$1) > ghostHeight) {
          allMarkers.push(parseInt(RegExp.$3));
        }
      }
    });

    // Sort the marker positions
    allMarkers.sort((a, b) => a - b);

    let markers = allMarkers.reduce(function (acc, cv) {
      if (
        !acc.some((arrVal) => {
          return cv <= arrVal + margin;
        })
      ) {
        acc.push(cv);
      }
      return acc;
    }, []);

    return markers;
  },
  parseGetVerticalPositionOutput: function (output, h, w) {
    var info = [];
    var buffer = 20;
    var ghostMargin = this.ghostMargin;
    // Fuzz logic is to take a specific percentage to match instead of all lines
    var fuzz = this.fuzzMargin;
    var overrideMargin = this.overrideMargin ? w * this.overrideMargin : -1;

    // Find the minimum x value which is common across all the rows
    // Not using the y value, but adding all the x points to an array
    // Ignore any marker position in extreme left (i.e < 50px)
    output.split("\n").forEach(function (line) {
      if (line.match(/^(.*) (.*)$/)) {
        if (parseInt(RegExp.$1) > ghostMargin) {
          info.push(parseInt(RegExp.$1));
        }
      }
    });
    // Find counts for each x point and keep a map
    let counts = info.reduce(function (acc, cv) {
      if (cv in acc) {
        acc[cv]++;
      } else {
        acc[cv] = 1;
      }
      return acc;
    }, {});

    // Assuming the point is available in all the lines
    // Get the point whose counter is equal to the
    // TODO:We can add a fuzz logic later
    let minXPosition =
      parseInt(
        Object.keys(counts).find((i) => {
          return counts[i] >= h * fuzz;
        })
      ) + buffer || overrideMargin;

    return minXPosition;
  },
  getInfo: function () {
    var self = this;
    var getInfoCommand = this.constructGetInfoCommand();
    var promise = new Promise(function (resolve, reject) {
      exec(getInfoCommand, function (err, stdout, stderr) {
        if (err) {
          return reject({
            message: "Failed to get PDF'S information",
            error: err,
            stdout: stdout,
            stderr: stderr,
          });
        }
        return resolve(self.parseGetInfoCommandOutput(stdout));
      });
    });
    return promise;
  },
  numberOfPages: function () {
    return this.getInfo().then(function (info) {
      return info["Pages"];
    });
  },
  getOutputImagePathForPage: function (pageNumber) {
    return path.join(
      this.outputDirectory,
      this.pdfFileBaseName + "-" + pageNumber + "." + this.convertExtension
    );
  },
  getOutputImagePathForFile: function () {
    return path.join(
      this.outputDirectory,
      this.pdfFileBaseName + "." + this.convertExtension
    );
  },
  setConvertOptions: function (convertOptions) {
    this.convertOptions = convertOptions || {};
  },
  setPdfFileBaseName: function (pdfFileBaseName) {
    this.pdfFileBaseName =
      pdfFileBaseName || path.basename(this.pdfFilePath, ".pdf");
  },
  setConvertExtension: function (convertExtension) {
    this.convertExtension = convertExtension || "png";
  },
  constructConvertCommandForPage: function (pageNumber) {
    var pdfFilePath = this.pdfFilePath;
    var outputImagePath = this.getOutputImagePathForPage(pageNumber);
    var convertOptionsString = this.constructConvertOptions();
    return util.format(
      '%s %s"%s[%d]" "%s"',
      this.useGM ? "gm convert" : "convert",
      convertOptionsString ? convertOptionsString + " " : "",
      pdfFilePath,
      pageNumber,
      outputImagePath
    );
  },
  constructConvertCommandForPageList: function (pageList, pageNumber) {
    var pdfFilePath = this.pdfFilePath;
    var outputImagePath = pageNumber
      ? this.getOutputImagePathForPage(pageNumber)
      : this.getOutputImagePathForFile();
    var convertOptionsString = this.constructConvertOptions();
    return util.format(
      '%s %s"%s[%s]" "%s"',
      this.useGM ? "gm convert" : "convert",
      convertOptionsString ? convertOptionsString + " " : "",
      pdfFilePath,
      pageList,
      outputImagePath
    );
  },
  constructCombineCommandForFile: function (imagePaths) {
    return util.format(
      '%s -append %s "%s"',
      this.useGM ? "gm convert" : "convert",
      imagePaths.join(" "),
      this.getOutputImagePathForFile()
    );
  },
  constructConvertOptions: function () {
    return Object.keys(this.convertOptions)
      .sort()
      .map(function (optionName) {
        if (this.convertOptions[optionName] !== null) {
          return optionName + " " + this.convertOptions[optionName];
        } else {
          return optionName;
        }
      }, this)
      .join(" ");
  },
  combineImages: function (imagePaths) {
    var pdfImage = this;
    var combineCommand = pdfImage.constructCombineCommandForFile(imagePaths);
    return new Promise(function (resolve, reject) {
      exec(combineCommand, function (err, stdout, stderr) {
        if (err) {
          return reject({
            message: "Failed to combine images",
            error: err,
            stdout: stdout,
            stderr: stderr,
          });
        }
        exec("rm " + imagePaths.join(" ")); //cleanUp
        return resolve(pdfImage.getOutputImagePathForFile());
      });
    });
  },
  convertFile: function () {
    var pdfImage = this;
    return new Promise(function (resolve, reject) {
      pdfImage.numberOfPages().then(function (totalPages) {
        const pages = Array.from(Array(totalPages * 1).keys());
        var imagePaths = [];
        let x = pages.reduce((accumulatorPromise, page) => {
          return accumulatorPromise.then(() => {
            return pdfImage
              .convertPage(page)
              .then(function (imagePath) {
                imagePaths.push(imagePath);
              })
              .catch(function (error) {
                reject(error);
              });
          });
        }, Promise.resolve());
        x.then(() => {
          resolve(imagePaths);
        }).catch(function (error) {
          reject(error);
        });
      });
    });
  },
  convertFileP: function () {
    var pdfImage = this;
    return new Promise(function (resolve, reject) {
      pdfImage.numberOfPages().then(function (totalPages) {
        var convertPromise = new Promise(function (resolve, reject) {
          var imagePaths = [];
          for (var i = 0; i < totalPages; i++) {
            pdfImage
              .convertPage(i)
              .then(function (imagePath) {
                imagePaths.push(imagePath);
                if (imagePaths.length === parseInt(totalPages)) {
                  imagePaths.sort(); //because of asyc pages we have to reSort pages
                  resolve(imagePaths);
                }
              })
              .catch(function (error) {
                reject(error);
              });
          }
        });

        convertPromise
          .then(function (imagePaths) {
            if (pdfImage.combinedImage) {
              pdfImage.combineImages(imagePaths).then(function (imagePath) {
                resolve(imagePath);
              });
            } else {
              resolve(imagePaths);
            }
          })
          .catch(function (error) {
            reject(error);
          });
      });
    });
  },
  convertPage: function (pageNumber) {
    var pdfFilePath = this.pdfFilePath;
    var outputImagePath = this.getOutputImagePathForPage(pageNumber);
    var convertCommand = this.constructConvertCommandForPage(pageNumber);

    var promise = new Promise(function (resolve, reject) {
      function convertPageToImage() {
        exec(convertCommand, function (err, stdout, stderr) {
          if (err) {
            return reject({
              message: "Failed to convert page to image",
              error: err,
              stdout: stdout,
              stderr: stderr,
            });
          }
          return resolve(outputImagePath);
        });
      }

      fs.stat(outputImagePath, function (err, imageFileStat) {
        var imageNotExists = err && err.code === "ENOENT";
        if (!imageNotExists && err) {
          return reject({
            message: "Failed to stat image file",
            error: err,
          });
        }

        // convert when (1) image doesn't exits or (2) image exists
        // but its timestamp is older than pdf's one

        if (imageNotExists) {
          // (1)
          convertPageToImage();
          return;
        }

        // image exist. check timestamp.
        fs.stat(pdfFilePath, function (err, pdfFileStat) {
          if (err) {
            return reject({
              message: "Failed to stat PDF file",
              error: err,
            });
          }

          if (imageFileStat.mtime < pdfFileStat.mtime) {
            // (2)
            convertPageToImage();
            return;
          }

          return resolve(outputImagePath);
        });
      });
    });
    return promise;
  },

  combineImagesToPDF: function (imagePaths) {
    var pdfImage = this;
    var convertOptionsString = this.constructConvertOptions();
    var combineCommand = util.format(
      '%s %s %s "%s"',
      this.useGM ? "gm convert" : "convert",
      imagePaths.join(" "),
      convertOptionsString ? convertOptionsString + " " : "",
      this.getOutputImagePathForFile()
    );
    return new Promise(function (resolve, reject) {
      exec(combineCommand, function (err, stdout, stderr) {
        if (err) {
          return reject({
            message: "Failed to combine images",
            error: err,
            stdout: stdout,
            stderr: stderr,
          });
        }
        //exec("rm "+imagePaths.join(' ')); //cleanUp
        return resolve(pdfImage.getOutputImagePathForFile());
      });
    });
  },

  suggestMarkers: function (w, h, x, y, mask) {
    // Using convert utility to find first vertical line
    // in the image file. The input is an image file.
    var self = this;
    var mask = mask || 17;
    const fileBaseName = path.basename(self.pdfFilePath, ".jpg");
    // convert  cam1f.jpg -crop 277x2111+0+0 +repage
    if (self.debug) {
      var opt = `-strip \\( +clone  -threshold 75% -write mpr:ORG  +delete -write ${fileBaseName}-1.png \\) \
\\( mpr:ORG  -negate  -morphology Erode rectangle:${mask}x1  -write ${fileBaseName}-2.png -mask mpr:ORG -morphology Dilate rectangle:${mask}x1 -write ${fileBaseName}-3.png +mask  -morphology Dilate Disk:3 -write ${fileBaseName}-4.png \\) \
\\( mpr:ORG  -negate  -morphology Erode rectangle:1x${mask}  -write ${fileBaseName}-5.png -mask mpr:ORG -morphology Dilate rectangle:1x${mask}  -write ${fileBaseName}-6.png +mask  -morphology Dilate Disk:3 -write ${fileBaseName}-7.png \\) \
\\( -clone 1 -clone 2 -evaluate-sequence add -write ${fileBaseName}-8.png \\) \
-delete 1,2 -compose plus -composite \\( +clone -write ${fileBaseName}-9.png \\) \
-compose Lighten -composite  -blur 0x0.5 -threshold 70% -write ${fileBaseName}-10.png \
-define connected-components:verbose=true -define connected-components:area-threshold=40 -connected-components 8 `;
    } else {
      var opt = `-strip \\( +clone  -threshold 75% -write mpr:ORG  +delete \\) \
\\( mpr:ORG  -negate  -morphology Erode rectangle:${mask}x1   -mask mpr:ORG -morphology Dilate rectangle:${mask}x1  +mask  -morphology Dilate Disk:3  \\) \
\\( mpr:ORG  -negate  -morphology Erode rectangle:1x${mask}   -mask mpr:ORG -morphology Dilate rectangle:1x${mask}  +mask  -morphology Dilate Disk:3  \\) \
\\( -clone 1 -clone 2 -evaluate-sequence add  \\) \
-delete 1,2 -compose plus -composite \\( +clone  \\) \
-compose Lighten -composite  -blur 0x0.5 -threshold 70%  \
-define connected-components:verbose=true -define connected-components:area-threshold=40 -connected-components 8 `;
    }

    var pdfFilePath = self.pdfFilePath;
    // using null output, to avoid intermediate files
    var outputImagePath = "null";

    var convertOptionsString = self.constructConvertOptions();
    var additionalOptions = util.format(
      "-crop %sx%s+%s+%s +repage %s",
      w - this.ghostMargin,
      h,
      x + this.ghostMargin,
      y,
      opt
    );
    var command = util.format(
      //  "%s %s\"%s\" \"%s\" \| grep \"#000000\" \| head -n 500 \| awk -F'[,: ]' '{print $1,$2}'",
      '%s %s "%s" %s "%s" | grep "(0,0,0)" | awk -F\'[x+,: ]\' \'{print $6,$7,$8}\'',
      this.useGM ? "gm convert" : "convert",
      convertOptionsString ? convertOptionsString + " " : "",
      pdfFilePath,
      additionalOptions,
      outputImagePath
    );

    // console.log(command);
    return new Promise(function (resolve, reject) {
      exec(command, function (err, stdout, stderr) {
        if (err) {
          return reject({
            message: "Failed to get markers",
            error: err,
            stdout: stdout,
            stderr: stderr,
          });
        }
        return resolve(self.parseGetMarkerOutput(stdout));
      });
    });
  },
  suggestMarkers1: function (w, h, x, y) {
    // Using convert utility to find first vertical line
    // in the image file. The input is an image file.

    var self = this;
    const fileBaseName = path.basename(self.pdfFilePath, ".jpg");
    // convert  cam1f.jpg -crop 277x2111+0+0 +repage
    if (self.debug) {
      var opt = `-strip \\( +clone  -threshold 75%  -write ${fileBaseName}-o1.png -write mpr:ORG  +delete -write ${fileBaseName}-o2.png \\) \
\\( mpr:ORG  -negate  -morphology Erode rectangle:200x1  -write ${fileBaseName}-o3.png -mask mpr:ORG -morphology Dilate rectangle:200x1 -write ${fileBaseName}-o4.png +mask  -morphology Dilate Disk:3 -write ${fileBaseName}-o5.png \\) \
\\( mpr:ORG  -negate  -morphology Erode rectangle:1x70   -write ${fileBaseName}-o6.png -mask mpr:ORG -morphology Dilate rectangle:1x70  -write ${fileBaseName}-o7.png +mask  -morphology Dilate Disk:3 -write ${fileBaseName}-o8.png \\) \
\\( -clone 1 -clone 2 -evaluate-sequence add -write ${fileBaseName}-o9.png \\) \
-delete 1,2 -compose plus -composite \\( +clone -write ${fileBaseName}-o10.png \\) \
-compose Lighten -composite  -blur 0x0.5 -threshold 70% -write ${fileBaseName}-o11.png \
-define connected-components:verbose=true -define connected-components:area-threshold=40 -connected-components 8 `;
    } else {
      var opt = `-strip \\( +clone  -threshold 75%  -write mpr:ORG  +delete  \\) \
\\( mpr:ORG  -negate  -morphology Erode rectangle:200x1  -mask mpr:ORG -morphology Dilate rectangle:200x1  +mask  -morphology Dilate Disk:3  \\) \
\\( mpr:ORG  -negate  -morphology Erode rectangle:1x70   -mask mpr:ORG -morphology Dilate rectangle:1x70   +mask  -morphology Dilate Disk:3  \\) \
\\( -clone 1 -clone 2 -evaluate-sequence add  \\) \
-delete 1,2 -compose plus -composite \\( +clone  \\) \
-compose Lighten -composite  -blur 0x0.5 -threshold 70%  \
-define connected-components:verbose=true -define connected-components:area-threshold=40 -connected-components 8 `;
    }

    var pdfFilePath = self.pdfFilePath;
    // using null output, to avoid intermediate files
    var outputImagePath = "null";

    var convertOptionsString = self.constructConvertOptions();
    var additionalOptions = util.format(
      "-crop %sx%s+%s+%s +repage %s",
      w - this.ghostMargin,
      h,
      x + this.ghostMargin,
      y,
      opt
    );
    var command = util.format(
      //  "%s %s\"%s\" \"%s\" \| grep \"#000000\" \| head -n 500 \| awk -F'[,: ]' '{print $1,$2}'",
      '%s %s "%s" %s "%s" | grep "(0,0,0)" | awk -F\'[x+,: ]\' \'{print $6,$7,$8}\'',
      this.useGM ? "gm convert" : "convert",
      convertOptionsString ? convertOptionsString + " " : "",
      pdfFilePath,
      additionalOptions,
      outputImagePath
    );

    // console.log(command);
    return new Promise(function (resolve, reject) {
      exec(command, function (err, stdout, stderr) {
        if (err) {
          return reject({
            message: "Failed to get markers",
            error: err,
            stdout: stdout,
            stderr: stderr,
          });
        }
        return resolve(self.parseGetMarkerOutput(stdout));
      });
    });
  },
  suggestMargin: function (w, h, x, y) {
    // Using convert utility to find first vertical line
    // in the image file. The input is an image file.
    var self = this;

    var pdfFilePath = self.pdfFilePath;
    // using text output as stdout
    var outputImagePath = "txt:-";

    var convertOptionsString = self.constructConvertOptions();
    var additionalOptions = util.format(
      "-crop %sx%s+%s+%s +repage ",
      w,
      h,
      x,
      y
    );
    var command = util.format(
      //  "%s %s\"%s\" \"%s\" \| grep \"#000000\" \| head -n 500 \| awk -F'[,: ]' '{print $1,$2}'",
      '%s %s %s"%s" "%s" | grep "#000000" | awk -F\'[,: ]\' \'{print $1,$2}\'',
      this.useGM ? "gm convert" : "convert",
      convertOptionsString ? convertOptionsString + " " : "",
      additionalOptions,
      pdfFilePath,
      outputImagePath
    );

    return new Promise(function (resolve, reject) {
      exec(command, function (err, stdout, stderr) {
        if (err) {
          return reject({
            message: "Failed to run command",
            error: err,
            stdout: stdout,
            stderr: stderr,
          });
        }
        return resolve(self.parseGetVerticalPositionOutput(stdout, h, w));
      });
    });
  },

  splitPages: function (pageList, pageNumber) {
    // Since this library uses imagemagick's convert utility,
    // The same can be used for a specific use case of splitting a PDF
    // Into smaller chunks.
    // The assumption is that the output is also a PDF file,
    // hence use the same output file name as for convertFile() method

    // pageList is a string of form "1,3,7" for disjoint pages or "3-6" for contiguous pages
    var pdfFilePath = this.pdfFilePath;
    var outputImagePath = pageNumber
      ? this.getOutputImagePathForPage(pageNumber)
      : this.getOutputImagePathForFile();
    var convertCommand = this.constructConvertCommandForPageList(
      pageList,
      pageNumber
    );

    var promise = new Promise(function (resolve, reject) {
      function convertPageToImage() {
        exec(convertCommand, function (err, stdout, stderr) {
          if (err) {
            return reject({
              message: "Failed to convert page to image",
              error: err,
              stdout: stdout,
              stderr: stderr,
            });
          }
          return resolve(outputImagePath);
        });
      }

      fs.stat(outputImagePath, function (err, imageFileStat) {
        var imageNotExists = err && err.code === "ENOENT";
        if (!imageNotExists && err) {
          return reject({
            message: "Failed to stat image file",
            error: err,
          });
        }

        // convert when (1) image doesn't exits or (2) image exists
        // but its timestamp is older than pdf's one

        if (imageNotExists) {
          // (1)
          convertPageToImage();
          return;
        }

        // image exist. check timestamp.
        fs.stat(pdfFilePath, function (err, pdfFileStat) {
          if (err) {
            return reject({
              message: "Failed to stat PDF file",
              error: err,
            });
          }

          if (imageFileStat.mtime < pdfFileStat.mtime) {
            // (2)
            convertPageToImage();
            return;
          }

          return resolve(outputImagePath);
        });
      });
    });
    return promise;
  },
};

exports.PDFImage = PDFImage;

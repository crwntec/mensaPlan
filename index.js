import moment from "moment";
import axios from "axios";
import { PDFExtract } from "pdf.js-extract";
import { MongoClient } from "mongodb";
import { promisify } from "util";

const connectionString = `mongodb+srv://mensa:${process.env['db_password']}@mensa.mrn5ciq.mongodb.net/?retryWrites=true&w=majority&appName=mensa`;

const client = new MongoClient(connectionString);

moment.locale("de");
const currentWeekNumber = moment().week();

async function fetchAndCreateBuffer(url) {
  try {
    const response = await axios.get(url, { responseType: "arraybuffer" });
    return Buffer.from(response.data);
  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
}

const url = `https://www.malteser-st-bernhard-gymnasium.de/fileadmin/Files_sites/Fachbereiche/St_Bernhard_Gymnasium/pdf/Mensaplaene/Speisenplan-KW_${currentWeekNumber}-Schule-merged.pdf`;

const pdfExtract = new PDFExtract();
const extractBuffer = promisify(pdfExtract.extractBuffer).bind(pdfExtract);
const options = {};

async function processPDF() {
  try {
    await client.connect();
    console.log("Connected to MongoDB");

    const buffer = await fetchAndCreateBuffer(url);
    const data = await extractBuffer(buffer, options);

    const currentWeek = data.pages[0].content;
    let dates = [];
    currentWeek.forEach((e) => {
      const date = moment(e.str, "LLLL");
      if (date.isValid()) {
        dates.push({
          date: date.format("LLLL"),
          ...e,
        });
      }
    });

    dates = dates.filter((o) => o.date.includes(o.str) && o.str.length > 5);
    dates.forEach((d, index) => {
      let items = currentWeek.filter((o) => o.x >= d.x && o.x <= d.x + d.width);
      items = items.filter(
        (o, index) => o.str !== " " && o.str !== "" && o.y < 365 && index > 0
      );

      if (!items[0]) {
        return;
      }

      let str = "";
      let meals = [];
      items.forEach((item) => {
        if (item.fontName === "g_d0_f1") {
          str += item.str + " ";
        } else {
          if (str !== "") {
            meals.push(str.trim());
            str = "";
          }
        }
      });
      dates[index] = {
        ...d,
        meals: meals,
      };
    });

    dates = dates.filter((o) => o.meals && o.meals.length > 0);

    const meals = client.db("Data").collection("meals");

    for (const d of dates) {
      for (const m of d.meals) {
        const existingMeal = await meals.findOne({ name: m });
        if (existingMeal) {
          await meals.updateOne({ name: m }, { $set: { lastSeen: d.date } });
          console.log("Updated", m);
        } else {
          await meals.insertOne({ name: m, lastSeen: d.date });
          console.log("Created", m);
        }
      }
    }

    console.log("Processing completed");
  } catch (error) {
    console.error("Error in processPDF:", error);
  } finally {
    await client.close();
    console.log("Disconnected from MongoDB");
  }
}

processPDF();

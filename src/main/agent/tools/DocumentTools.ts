/**
 * Document Generation Tools
 * Create Excel, Word, and PDF documents from extracted data
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import ExcelJS from 'exceljs';
import { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, HeadingLevel } from 'docx';
import PDFDocument from 'pdfkit';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

/**
 * Get default downloads directory
 */
function getDownloadsDir(): string {
  return app.getPath('downloads');
}

/**
 * Generate a timestamped filename with date and time
 */
function generateFilename(prefix: string, extension: string): string {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, '-').replace('T', '_').split('.')[0];
  return `${prefix}_${timestamp}.${extension}`;
}

/**
 * Create Excel file with data
 */
async function createExcelFile(
  data: Record<string, any>[] | Record<string, any>,
  filename: string,
  sheetName: string = 'Sheet1'
): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet(sheetName);

  // Convert data to array if it's a single object
  const dataArray = Array.isArray(data) ? data : [data];

  if (dataArray.length === 0) {
    throw new Error('No data provided for Excel file');
  }

  // Extract headers from first object
  const headers = Object.keys(dataArray[0]);

  // Add header row with styling
  const headerRow = worksheet.addRow(headers);
  headerRow.font = { bold: true, size: 12 };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF4472C4' },
  };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

  // Add data rows
  dataArray.forEach((item) => {
    const values = headers.map((header) => item[header] ?? '');
    worksheet.addRow(values);
  });

  // Auto-fit columns
  worksheet.columns.forEach((column) => {
    let maxLength = 0;
    column.eachCell?.({ includeEmpty: true }, (cell) => {
      const columnLength = cell.value ? String(cell.value).length : 10;
      if (columnLength > maxLength) {
        maxLength = columnLength;
      }
    });
    column.width = Math.min(maxLength + 2, 50);
  });

  // Add borders to all cells
  worksheet.eachRow((row) => {
    row.eachCell((cell) => {
      cell.border = {
        top: { style: 'thin' },
        left: { style: 'thin' },
        bottom: { style: 'thin' },
        right: { style: 'thin' },
      };
    });
  });

  // Save file
  const downloadsDir = getDownloadsDir();
  const filePath = path.join(downloadsDir, filename);
  console.log(`📁 Saving Excel file to: ${filePath}`);
  await workbook.xlsx.writeFile(filePath);
  console.log(`✅ Excel file saved successfully!`);

  return filePath;
}

/**
 * Create Word document with formatted content
 */
async function createWordDocument(
  content: {
    title?: string;
    sections: Array<{
      heading?: string;
      paragraphs?: string[];
      table?: Record<string, any>[];
    }>;
  },
  filename: string
): Promise<string> {
  const doc = new Document({
    sections: [
      {
        properties: {},
        children: [
          // Title
          ...(content.title
            ? [
                new Paragraph({
                  text: content.title,
                  heading: HeadingLevel.TITLE,
                  spacing: { after: 400 },
                }),
              ]
            : []),

          // Sections
          ...content.sections.flatMap((section) => {
            const elements: (Paragraph | Table)[] = [];

            // Section heading
            if (section.heading) {
              elements.push(
                new Paragraph({
                  text: section.heading,
                  heading: HeadingLevel.HEADING_1,
                  spacing: { before: 400, after: 200 },
                })
              );
            }

            // Paragraphs
            if (section.paragraphs) {
              section.paragraphs.forEach((para) => {
                elements.push(
                  new Paragraph({
                    children: [new TextRun(para)],
                    spacing: { after: 200 },
                  })
                );
              });
            }

            // Table
            if (section.table && section.table.length > 0) {
              const headers = Object.keys(section.table[0]);

              const tableRows = [
                // Header row
                new TableRow({
                  children: headers.map(
                    (header) =>
                      new TableCell({
                        children: [
                          new Paragraph({
                            children: [
                              new TextRun({
                                text: header,
                                bold: true,
                              }),
                            ],
                          }),
                        ],
                      })
                  ),
                }),
                // Data rows
                ...section.table.map(
                  (row) =>
                    new TableRow({
                      children: headers.map(
                        (header) =>
                          new TableCell({
                            children: [new Paragraph(String(row[header] ?? ''))],
                          })
                      ),
                    })
                ),
              ];

              elements.push(
                new Table({
                  rows: tableRows,
                  width: {
                    size: 100,
                    type: 'pct',
                  },
                })
              );
            }

            return elements;
          }),
        ],
      },
    ],
  });

  // Save file
  const downloadsDir = getDownloadsDir();
  const filePath = path.join(downloadsDir, filename);
  console.log(`📁 Saving Word document to: ${filePath}`);
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(filePath, buffer);
  console.log(`✅ Word document saved successfully!`);

  return filePath;
}

/**
 * Create PDF document with content
 */
async function createPDFDocument(
  content: {
    title?: string;
    sections: Array<{
      heading?: string;
      paragraphs?: string[];
      table?: Record<string, any>[];
    }>;
  },
  filename: string
): Promise<string> {
  const downloadsDir = getDownloadsDir();
  const filePath = path.join(downloadsDir, filename);
  console.log(`📁 Saving PDF document to: ${filePath}`);
  const doc = new PDFDocument({ margin: 50 });
  const stream = fs.createWriteStream(filePath);

  doc.pipe(stream);

  // Title
  if (content.title) {
    doc.fontSize(20).font('Helvetica-Bold').text(content.title, { align: 'center' });
    doc.moveDown(2);
  }

  // Sections
  content.sections.forEach((section) => {
    // Section heading
    if (section.heading) {
      doc.fontSize(16).font('Helvetica-Bold').text(section.heading);
      doc.moveDown(0.5);
    }

    // Paragraphs
    if (section.paragraphs) {
      section.paragraphs.forEach((para) => {
        doc.fontSize(12).font('Helvetica').text(para);
        doc.moveDown(0.5);
      });
    }

    // Table
    if (section.table && section.table.length > 0) {
      const headers = Object.keys(section.table[0]);
      const tableTop = doc.y;
      const itemHeight = 25;
      const columnWidth = (doc.page.width - 100) / headers.length;

      // Draw headers
      doc.fontSize(10).font('Helvetica-Bold');
      headers.forEach((header, i) => {
        doc.text(header, 50 + i * columnWidth, tableTop, {
          width: columnWidth,
          align: 'center',
        });
      });

      doc.moveTo(50, tableTop + itemHeight).lineTo(doc.page.width - 50, tableTop + itemHeight).stroke();

      // Draw rows
      doc.font('Helvetica');
      section.table.forEach((row, rowIndex) => {
        const y = tableTop + itemHeight * (rowIndex + 1) + 5;
        headers.forEach((header, i) => {
          doc.text(String(row[header] ?? ''), 50 + i * columnWidth, y, {
            width: columnWidth,
            align: 'center',
          });
        });
      });

      doc.moveDown(2);
    }

    doc.moveDown(1);
  });

  doc.end();

  return new Promise((resolve, reject) => {
    stream.on('finish', () => {
      console.log(`✅ PDF document saved successfully!`);
      resolve(filePath);
    });
    stream.on('error', reject);
  });
}

/**
 * Create document generation tools
 */
export function createDocumentTools() {
  return [
    // Excel generation
    new DynamicStructuredTool({
      name: 'create_excel',
      description:
        'Create an Excel spreadsheet from structured data. Automatically formats data into a professional table with headers, borders, and styling. Perfect for data analysis, reports, and structured information.',
      schema: z.object({
        data: z
          .union([z.array(z.record(z.any())), z.record(z.any())])
          .describe(
            'Data to include in Excel. Can be array of objects (for rows) or single object. Each object key becomes a column header.'
          ),
        filename: z
          .string()
          .optional()
          .describe('Filename for the Excel file (optional, auto-generated if not provided)'),
        sheetName: z.string().optional().default('Data').describe('Name of the Excel sheet'),
      }),
      func: async ({ data, filename, sheetName }) => {
        try {
          const finalFilename = filename || generateFilename('data', 'xlsx');
          const filePath = await createExcelFile(data, finalFilename, sheetName);

          return `✅ Excel file created successfully!
📁 Location: ${filePath}
📊 Rows: ${Array.isArray(data) ? data.length : 1}
📋 Columns: ${Object.keys(Array.isArray(data) ? data[0] : data).length}

The file has been saved to your Downloads folder and can be opened with Excel, Google Sheets, or any spreadsheet application.`;
        } catch (error) {
          return `❌ Failed to create Excel file: ${error instanceof Error ? error.message : String(error)}`;
        }
      },
    }),

    // Word document generation
    new DynamicStructuredTool({
      name: 'create_word',
      description:
        'Create a professional Word document (.docx) with formatted content including title, headings, paragraphs, and tables. Perfect for reports, summaries, and formatted documents.',
      schema: z.object({
        title: z.string().optional().describe('Document title (optional)'),
        sections: z
          .array(
            z.object({
              heading: z.string().optional().describe('Section heading'),
              paragraphs: z
                .array(z.string())
                .optional()
                .describe('Array of paragraph texts for this section'),
              table: z
                .array(z.record(z.any()))
                .optional()
                .describe('Optional data table for this section'),
            })
          )
          .describe('Array of document sections with headings, paragraphs, and optional tables'),
        filename: z
          .string()
          .optional()
          .describe('Filename for the Word document (optional, auto-generated if not provided)'),
      }),
      func: async ({ title, sections, filename }) => {
        try {
          const finalFilename = filename || generateFilename('document', 'docx');
          const filePath = await createWordDocument({ title, sections }, finalFilename);

          return `✅ Word document created successfully!
📁 Location: ${filePath}
📄 Sections: ${sections.length}
${title ? `📝 Title: ${title}` : ''}

The document has been saved to your Downloads folder and can be opened with Microsoft Word, Google Docs, or any compatible word processor.`;
        } catch (error) {
          return `❌ Failed to create Word document: ${error instanceof Error ? error.message : String(error)}`;
        }
      },
    }),

    // PDF generation
    new DynamicStructuredTool({
      name: 'create_pdf',
      description:
        'Create a PDF document with formatted content including title, headings, paragraphs, and tables. Perfect for reports, summaries, and shareable documents.',
      schema: z.object({
        title: z.string().optional().describe('Document title (optional)'),
        sections: z
          .array(
            z.object({
              heading: z.string().optional().describe('Section heading'),
              paragraphs: z
                .array(z.string())
                .optional()
                .describe('Array of paragraph texts for this section'),
              table: z
                .array(z.record(z.any()))
                .optional()
                .describe('Optional data table for this section'),
            })
          )
          .describe('Array of document sections with headings, paragraphs, and optional tables'),
        filename: z
          .string()
          .optional()
          .describe('Filename for the PDF (optional, auto-generated if not provided)'),
      }),
      func: async ({ title, sections, filename }) => {
        try {
          const finalFilename = filename || generateFilename('document', 'pdf');
          const filePath = await createPDFDocument({ title, sections }, finalFilename);

          return `✅ PDF created successfully!
📁 Location: ${filePath}
📄 Sections: ${sections.length}
${title ? `📝 Title: ${title}` : ''}

The PDF has been saved to your Downloads folder and can be opened with any PDF reader.`;
        } catch (error) {
          return `❌ Failed to create PDF: ${error instanceof Error ? error.message : String(error)}`;
        }
      },
    }),
  ];
}

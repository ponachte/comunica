type Resource = Record<string, any>;

function flattenResponse(obj: any, prefix = ''): Resource[] {
  if (Array.isArray(obj)) {
    // Flatten each item in the array and combine results
    return obj.flatMap(item => flattenResponse(item, prefix));
  }

  if (typeof obj !== 'object' || obj === null) {
    // Primitive value — wrap in an object
    return [{ [prefix]: obj }];
  }

  const entries: Resource[] = [{}];

  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}_${key}` : key;
    const flattened = flattenResponse(value, fullKey);

    // Combine each flattened result with the existing entries
    const combined: Resource[] = [];

    for (const entry of entries) {
      for (const flat of flattened) {
        combined.push({ ...entry, ...flat });
      }
    }

    entries.splice(0, entries.length, ...combined); // Replace entries
  }

  return entries;
}

const response = {
  "data": {
    "persons": [
      {
        "id": "http://example.org/Person69",
        "ex_knows": {
          "id": "http://example.org/Person22"
        }
      },
      {
        "id": "http://example.org/Person436",
        "ex_knows": {
          "id": "http://example.org/Person316"
        }
      },
      {
        "id": "http://example.org/Person258",
        "ex_knows": {
          "id": "http://example.org/Person319"
        }
      },
      {
        "id": "http://example.org/Person323",
        "ex_knows": {
          "id": "http://example.org/Person294"
        }
      },
      {
        "id": "http://example.org/Person411",
        "ex_knows": {
          "id": "http://example.org/Person488"
        }
      },
      {
        "id": "http://example.org/Person304",
        "ex_knows": {
          "id": "http://example.org/Person196"
        }
      },
      {
        "id": "http://example.org/Person148",
        "ex_knows": {
          "id": "http://example.org/Person291"
        }
      },
      {
        "id": "http://example.org/Person414",
        "ex_knows": {
          "id": "http://example.org/Person283"
        }
      },
      {
        "id": "http://example.org/Person398",
        "ex_knows": {
          "id": "http://example.org/Person64"
        }
      },
      {
        "id": "http://example.org/Person301",
        "ex_knows": {
          "id": "http://example.org/Person229"
        }
      },
      {
        "id": "http://example.org/Person488",
        "ex_knows": {
          "id": "http://example.org/Person312"
        }
      },
      {
        "id": "http://example.org/Person433",
        "ex_knows": {
          "id": "http://example.org/Person451"
        }
      },
      {
        "id": "http://example.org/Person326",
        "ex_knows": {
          "id": "http://example.org/Person251"
        }
      },
      {
        "id": "http://example.org/Person66",
        "ex_knows": {
          "id": "http://example.org/Person193"
        }
      },
      {
        "id": "http://example.org/Person41",
        "ex_knows": {
          "id": "http://example.org/Person452"
        }
      },
      {
        "id": "http://example.org/Person392",
        "ex_knows": {
          "id": "http://example.org/Person115"
        }
      },
      {
        "id": "http://example.org/Person270",
        "ex_knows": {
          "id": "http://example.org/Person186"
        }
      },
      {
        "id": "http://example.org/Person147",
        "ex_knows": {
          "id": "http://example.org/Person155"
        }
      },
      {
        "id": "http://example.org/Person487",
        "ex_knows": {
          "id": "http://example.org/Person211"
        }
      },
      {
        "id": "http://example.org/Person439",
        "ex_knows": {
          "id": "http://example.org/Person421"
        }
      },
      {
        "id": "http://example.org/Person160",
        "ex_knows": {
          "id": "http://example.org/Person194"
        }
      },
      {
        "id": "http://example.org/Person257",
        "ex_knows": {
          "id": "http://example.org/Person49"
        }
      },
      {
        "id": "http://example.org/Person165",
        "ex_knows": {
          "id": "http://example.org/Person407"
        }
      },
      {
        "id": "http://example.org/Person252",
        "ex_knows": {
          "id": "http://example.org/Person193"
        }
      },
      {
        "id": "http://example.org/Person329",
        "ex_knows": {
          "id": "http://example.org/Person381"
        }
      },
      {
        "id": "http://example.org/Person397",
        "ex_knows": {
          "id": "http://example.org/Person11"
        }
      },
    ]
  }
}

console.log(flattenResponse(response.data));